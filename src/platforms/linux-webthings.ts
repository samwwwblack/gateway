/**
 * WebThings OS platform interface.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import ip from 'ip';
import { Netmask } from 'netmask';
import BasePlatform from './base';
import fs from 'fs';
import child_process from 'child_process';
import { execFileSync } from 'child_process';
import NetworkManager, { ConnectionSettings } from './utilities/network-manager';
import { LanMode, NetworkAddresses, WirelessNetwork } from './types';

export class LinuxWebThingsOSPlatform extends BasePlatform {
    /**
     * Disconnect NetworkManager.
     */
    stop(): void {
        NetworkManager.stop();
    }

    /**
     * Get the current addresses for Wi-Fi and LAN.
     *
     * @returns {Promise<NetworkAddresses>} Promise that resolves with
     *   {
     *     lan: '...',
     *     wlan: {
     *      ip: '...',
     *      ssid: '...',
     *    }
     *  }
     */
    async getNetworkAddressesAsync(): Promise<NetworkAddresses> {
        const result: NetworkAddresses = {
            lan: '',
            wlan: {
                ip: '',
                ssid: '',
            },
        };
        try {
            const ethernetDevices = await NetworkManager.getEthernetDevices();
            const ethernetIp4Config = await NetworkManager.getDeviceIp4Config(ethernetDevices[0]);
            result.lan = ethernetIp4Config[0].address;
        } catch (error) {
            console.error(error);
            console.log('Unable to detect an Ethernet IP address');
        }
        try {
            const wifiDevices = await NetworkManager.getWifiDevices();
            const wifiIp4Config = await NetworkManager.getDeviceIp4Config(wifiDevices[0]);
            const accessPoint = await NetworkManager.getActiveAccessPoint(wifiDevices[0]);
            const ssid = await NetworkManager.getAccessPointSsid(accessPoint);
            result.wlan.ip = wifiIp4Config[0].address;
            result.wlan.ssid = ssid;
        } catch (error) {
            console.error(error);
            console.log('Unable to detect a Wi-Fi IP address and active SSID');
        }
        return result;
    }

    /**
     * Get LAN network settings.
     *
     * @returns {Promise<LanMode>} Promise that resolves with
     *   {mode: 'static|dhcp|...', options: {...}}
     */
    async getLanModeAsync(): Promise<LanMode> {
        const result: LanMode = {
            mode: '',
            options: {},
        };
        return NetworkManager.getEthernetDevices()
        .then((devices) => {
            return NetworkManager.getDeviceConnection(devices[0]);
        })
        .then((connection) => {
            return NetworkManager.getConnectionSettings(connection);
        })
        .then((settings: ConnectionSettings) => {
            if (settings && settings.ipv4 && settings.ipv4.method == 'auto') {
                result.mode = 'dhcp';
            } else if (settings && settings.ipv4 && settings.ipv4.method == 'manual') {
                result.mode = 'static';
            }
            if (settings.ipv4 && settings.ipv4['address-data'] && settings.ipv4['address-data'][0]) {
                if (settings.ipv4['address-data'][0].hasOwnProperty('address')) {
                    result.options.ipaddr = settings.ipv4['address-data'][0].address;
                }
                if (result.options.ipaddr && settings.ipv4['address-data'][0].hasOwnProperty('prefix')) {
                    // Convert cidr style prefix to dot-decimal netmask
                    const ip = result.options.ipaddr;
                    const cidr = settings.ipv4['address-data'][0].prefix;
                    const block = new Netmask(`${ip}/${cidr}`);
                    result.options.netmask = block.mask;
                }
            }
            if (settings.ipv4 && settings.ipv4.hasOwnProperty('gateway')) {
                result.options.gateway = settings.ipv4.gateway;
            }
            return result;
        })
        .catch((error) => {
            console.error(`Error getting LAN mode from Network Manager: ${error}`);
            return result;
        });
    }

    /**
     * Set LAN network settings.
     *
     * @param {string} mode static|dhcp|....
     * @param {Record<string, unknown>} options Mode-specific options.
     * @returns {Promise<boolean>} Promise that resolves true if successful and false if not.
     */
    async setLanModeAsync(mode: string, options: Record<string, unknown>): Promise<boolean> {
        let lanDevice: string;
        let lanConnection: string;
        return NetworkManager.getEthernetDevices()
        .then((devices) => {
            lanDevice = devices[0];
            return NetworkManager.getDeviceConnection(lanDevice);
        })
        .then((connection) => {
            lanConnection = connection;
            // First get current settings to carry over some values
            return NetworkManager.getConnectionSettings(lanConnection);
        })
        .then((oldSettings) => {
            // Carry over some values from the old settings
            const settings: ConnectionSettings = {
                connection: {
                    id: oldSettings.connection.id,
                    uuid: oldSettings.connection.uuid,
                    type: oldSettings.connection.type,
                },
            };

            if (mode == 'dhcp') {
                // Set dynamic IP
                settings.ipv4 = {
                    method: 'auto',
                };
            } else if (mode == 'static') {
                if (
                    !(
                        options.hasOwnProperty('ipaddr') &&
                        ip.isV4Format(<string>options.ipaddr) &&
                        options.hasOwnProperty('gateway') &&
                        ip.isV4Format(<string>options.gateway) &&
                        options.hasOwnProperty('netmask') &&
                        ip.isV4Format(<string>options.netmask)
                    )
                ) {
                    console.log(
                        'Setting a static IP address requires a valid IP address, gateway and netmask'
                    );
                    return false;
                }
                // Set static IP address
                // Convert dot-decimal netmask to cidr style prefix for storage
                const netmask = new Netmask(options.ipaddr as string, options.netmask as string);
                const prefix = netmask.bitmask;
                // Convert dot-decimal IP and gateway to little endian integers for storage
                const ipaddrReversed = (options.ipaddr as string).split('.').reverse().join('.');
                const ipaddrInt = ip.toLong(ipaddrReversed);
                const gatewayReversed = (options.gateway as string).split('.').reverse().join('.');
                const gatewayInt = ip.toLong(gatewayReversed);
                settings.ipv4 = {
                    method: 'manual',
                    addresses: [[ipaddrInt, prefix, gatewayInt]],
                    // The NetworkManager docs say that the addresses property is deprecated,
                    // but using address-data and gateway doesn't seem to work on Ubuntu yet.
                    /*
                     *         'address-data': [{
                     *           'address': options.ipaddr,
                     *           'prefix': prefix
                }],
                'gateway': options.gateway
                */
                };
            } else {
                console.error('LAN mode not recognised');
                return false;
            }
            return NetworkManager.setConnectionSettings(lanConnection, settings);
        })
        .then(() => {
            return NetworkManager.activateConnection(lanConnection, lanDevice);
        })
        .catch((error) => {
            console.error(`Error setting LAN settings: ${error}`);
            return false;
        });
    }

    /**
     * Scan for visible wireless networks on the first wireless device.
     *
     * @returns {Promise<WirelessNetwork[]>} Promise which resolves with an array
     *   of networks as objects:
     *  [
     *    {
     *      ssid: '...',
     *      quality: <number>,
     *      encryption: true|false,
     *      configured: true|false,
     *      connected: true|false
     *    },
     *    ...
     *  ]
     */
    async scanWirelessNetworksAsync(): Promise<WirelessNetwork[]> {
        const wifiDevices = await NetworkManager.getWifiDevices();
        const wifiAccessPoints = await NetworkManager.getWifiAccessPoints(wifiDevices[0]);
        let activeAccessPoint: string | null;
        try {
            activeAccessPoint = await NetworkManager.getActiveAccessPoint(wifiDevices[0]);
        } catch (error) {
            activeAccessPoint = null;
        }
        const apRequests: Array<Promise<WirelessNetwork>> = [];
        wifiAccessPoints.forEach((ap) => {
            apRequests.push(NetworkManager.getAccessPointDetails(ap, activeAccessPoint));
        });
        const responses = await Promise.all(apRequests);
        return responses;
    }

    /**
     * Set the wireless mode and options.
     *
     * @param {boolean} enabled - whether or not wireless is enabled
     * @param {string} mode - ap, sta, ...
     * @param {Record<string, unknown>} options - options specific to wireless mode
     * @returns {Promise<boolean>} Boolean indicating success.
     */
    async setWirelessModeAsync(
        enabled: boolean,
        mode = 'ap',
        options: Record<string, unknown> = {}
    ): Promise<boolean> {
        const valid = [
            // 'ap', //TODO: Implement ap mode
            'sta',
        ];
        if (enabled && !valid.includes(mode)) {
            console.error(`Wireless mode ${mode} not supported on this platform`);
            return false;
        }
        const wifiDevices = await NetworkManager.getWifiDevices();

        // If `enabled` set to false, disconnect wireless device
        if (enabled === false) {
            // Return false if no wifi device found
            if (!wifiDevices[0]) {
                return false;
            }
            try {
                await NetworkManager.disconnectNetworkDevice(wifiDevices[0]);
            } catch (error) {
                console.error(`Error whilst attempting to disconnect wireless device: ${error}`);
                return false;
            }
            return true;
        }

        // Otherwise connect to Wi-Fi access point using provided options
        if (!options.hasOwnProperty('ssid')) {
            console.log('Could not connect to wireless network because no SSID provided');
            return false;
        }
        const accessPoint = await NetworkManager.getAccessPointbySsid(options.ssid as string);
        if (accessPoint == null) {
            console.log('No network with specified SSID found');
            return false;
        }
        let secure = false;
        if (options.key) {
            secure = true;
        }
        try {
            NetworkManager.connectToWifiAccessPoint(
                wifiDevices[0],
                accessPoint,
                <string>options.ssid,
                secure,
                <string>options.key
            );
        } catch (error) {
            console.error(`Error connecting to Wi-Fi access point: ${error}`);
            return false;
        }
        return true;
    }

    /**
     * Get a list of all valid wi-fi countries for the system.
     *
     * @returns {string[]} List of countries.
     */
    getValidWirelessCountries(): string[] {
        const fname = '/usr/share/zoneinfo/iso3166.tab';
        if (!fs.existsSync(fname)) {
            return [];
        }

        try {
            const data = fs.readFileSync(fname, 'utf8');
            const zones = data
            .split('\n')
            .filter((l) => !l.startsWith('#') && l.length > 0)
            .map((l) => l.split('\t')[1])
            .sort();

            return zones;
        } catch (e) {
            console.error('Failed to read zone file:', e);
        }

        return [];
    }

    /**
     * Get the current wireless regulatory domain.
     *
     * @returns {string} The full country name (e.g. 'United States', 'United Kingdom'),
     *   or empty string if unable to determine.
     */
    getWirelessCountry(): string {
        // Get the current country code
        try {
            const stdout = execFileSync('iw', ['reg', 'get'], { encoding: 'utf8' });
            // First try to find per-phy country (e.g. under "phy#0")
            let countryCode: string | null = null;
            const phyMatch = stdout.match(/phy#\d+[\s\S]*?country\s+(\w+):/);
            if (phyMatch && phyMatch[1]) {
                countryCode = phyMatch[1];
            } else {
                // Fall back to global country
                const globalMatch = stdout.match(/country\s+(\w+):/);
                if (globalMatch && globalMatch[1]) {
                    countryCode = globalMatch[1];
                }
            }

            if (!countryCode) {
                return '';
            }

            // Look up the country name from iso3166.tab
            const fname = '/usr/share/zoneinfo/iso3166.tab';
            if (!fs.existsSync(fname)) {
                return '';
            }

            const data = fs.readFileSync(fname, 'utf8');
            const lines = data.split('\n');
            for (const line of lines) {
                if (line.startsWith('#') || line.length === 0) {
                    continue;
                }
                const parts = line.split('\t');
                if (parts[0] === countryCode && parts[1]) {
                    return parts[1];
                }
            }
        } catch (error) {
            console.error(`Error getting wireless country: ${error}`);
        }

        return '';
    }

    /**
     * Get a list of all valid timezones for the system.
     *
     * @returns {string[]} List of timezones.
     */
    getValidTimezones(): string[] {
        const tzdata = '/usr/share/zoneinfo/zone.tab';
        if (!fs.existsSync(tzdata)) {
            return [];
        }

        try {
            const data = fs.readFileSync(tzdata, 'utf8');
            const zones = data
            .split('\n')
            .filter((l) => !l.startsWith('#') && l.length > 0)
            .map((l) => l.split(/\s+/g)[2])
            .sort();

            return zones;
        } catch (e) {
            console.error('Failed to read zone file:', e);
        }

        return [];
    }

    /**
     * Get the current timezone.
     *
     * @returns {string} Name of timezone.
     */
    getTimezone(): string {
        const proc = child_process.spawnSync('timedatectl', ['status'], { encoding: 'utf8' });

        if (proc.status !== 0) {
            return '';
        }

        const lines = proc.stdout.split('\n').map((l) => l.trim());
        const zone = lines.find((l) => l.startsWith('Time zone:'));

        if (!zone) {
            return '';
        }

        return zone.split(':')[1].split('(')[0].trim();
    }

    /**
     * Set the current timezone.
     *
     * @param {string} zone - The timezone to set
     * @returns {boolean} Boolean indicating success of the command.
     */
    setTimezone(_zone: string): boolean {
        const proc = child_process.spawnSync('timedatectl', ['set-timezone', _zone], { encoding: 'utf8' });

        return proc.status === 0;
    }

    /**
     * Get the NTP synchronization status.
     *
     * @returns {boolean} Boolean indicating whether or not the time has been
     *                    synchronized.
     */
    getNtpStatus(): boolean {
        const proc = child_process.spawnSync('timedatectl', ['status'], { encoding: 'utf8' });

        if (proc.status !== 0) {
            return false;
        }

        const lines = proc.stdout.split('\n').map((l) => l.trim());
        const status = lines.find((l) => l.startsWith('System clock synchronized:'));

        if (!status) {
            return false;
        }

        return status.split(':')[1].trim() === 'yes';
    }

    /**
     * Restart the NTP sync service.
     *
     * @returns {boolean} Boolean indicating success of the command.
     */
    restartNtpSync(): boolean {
        const proc = child_process.spawnSync('systemctl', [
            'restart',
            'chronyd-restricted.service',
        ]);

        return proc.status === 0;
    }

    /**
     * Get DHCP server status.
     *
     * @returns {boolean} Boolean indicating whether or not DHCP is enabled.
     */
    getDhcpServerStatus(): boolean {
        const proc = child_process.spawnSync('systemctl', ['is-active', 'dnsmasq.service']);
        return proc.status === 0;
    }

    /**
     * Set DHCP server status.
     *
     * @param {boolean} enabled - Whether or not to enable the DHCP server
     * @returns {boolean} Boolean indicating success of the command.
     */
    setDhcpServerStatus(enabled: boolean): boolean {
        // 'systemctl {enable|disable} --now <unit name>' will enable/disable the unit file,
        // and if running stop it at the same time.
        let proc = child_process.spawnSync('systemctl', [
            enabled ? 'enable' : 'disable',
            '--now',
            'dnsmasq.service',
        ]);
        return proc.status === 0;
    }

    /**
     * Get SSH server status.
     *
     * @returns {boolean} Boolean indicating whether or not SSH is enabled.
     */
    getSshServerStatus(): boolean {
        // We enable 'ssh.socket' by default, so check for socket and service
        const proc = child_process.spawnSync('systemctl', ['is-active', 'ssh.service', 'ssh.socket']);
        return proc.status === 0;
    }

    /**
     * Set SSH server socket status.
     *
     * @param {boolean} enabled - Whether or not to enable the SSH server socket
     * @returns {boolean} Boolean indicating success of the command.
     */
    setSshServerStatus(enabled: boolean): boolean {
        // TODO: Do we want to enable the socket or the server?
        let proc = child_process.spawnSync('systemctl', [
            enabled ? 'enable' : 'disable',
            '--now',
            'ssh.socket',
        ]);
        return proc.status === 0;
    }

    // TODO: Maybe use 'systemd-resolved' here for mDNS?
    /**
     * Get mDNS server status.
     *
     * @returns {boolean} Boolean indicating whether or not mDNS is enabled.
     */
    getMdnsServerStatus(): boolean {
        const proc = child_process.spawnSync('systemctl', ['is-active', 'avahi-daemon.service']);
        return proc.status === 0;
    }

    /**
     * Set mDNS server status.
     *
     * @param {boolean} enabled - Whether or not to enable the mDNS server
     * @returns {boolean} Boolean indicating success of the command.
     */
    setMdnsServerStatus(enabled: boolean): boolean {
        let proc = child_process.spawnSync('systemctl', [
            enabled ? 'enable' : 'disable',
            '--now',
            'avahi-daemon.service',
        ]);
        return proc.status === 0;
    }

    /**
     * Get the system's hostname.
     *
     * @returns {string} The hostname.
     */
    getHostname(): string {
        const proc = child_process.spawnSync('hostnamectl', ['hostname'], { encoding: 'utf8' });

        if (proc.status !== 0) {
            return 'gateway';
        }

        return proc.stdout.trim();
    }

    /**
     * Set the system's hostname.
     *
     * @param {string} hostname - The hostname to set
     * @returns {boolean} Boolean indicating success of the command.
     */
    setHostname(hostname: string): boolean {
        hostname = hostname.toLowerCase();
        const re = new RegExp(/^([a-z0-9]|[a-z0-9][a-z0-9-]*[a-z0-9])$/);
        const valid = re.test(hostname) && hostname.length <= 63;
        if (!valid) {
            return false;
        }

        // Read in the current hostname
        // TODO: Do we need this? 'hostnamectl hostname <hostname>' is atomic
        //let original = this.getHostname();

        let proc = child_process.spawnSync('hostnamectl', [
            'hostname',
            hostname
        ]);
        if (proc.status !== 0) {
            return false;
        }

        proc = child_process.spawnSync('systemctl', ['restart', 'avahi-daemon.service']);

        // We don't have '/etc/hosts' on WebThings

        return proc.status === 0;
    }

    /**
     * Restart the gateway process.
     *
     * @returns {boolean} Boolean indicating success of the command.
     */
    restartGateway(): boolean {
        const proc = child_process.spawnSync('systemctl', [
            'restart',
            'webthings-gateway.service',
        ]);

        // This will probably not fire, but just in case.
        return proc.status === 0;
    }

    /**
     * Restart the system.
     *
     * @returns {boolean} Boolean indicating success of the command.
     */
    restartSystem(): boolean {
        const proc = child_process.spawnSync('systemctl', ['reboot']);

        // This will probably not fire, but just in case.
        return proc.status === 0;
    }

    /**
     * Determine whether or not the gateway can auto-update itself.
     *
     * @returns {Object} {available: <bool>, enabled: <bool>}
     */
    getSelfUpdateStatus(): SelfUpdateStatus {
        const proc = child_process.spawnSync('systemctl', ['is-active', 'systemd-sysupdate.timer']);
        return proc.status === 0;
    }

    /**
     * Enable/disable auto-updates.
     *
     * @param {boolean} enabled - Whether or not to enable auto-updates.
     * @returns {boolean} Boolean indicating success of the command.
     */
    setSelfUpdateStatus(_enabled: boolean): boolean {
        let proc = child_process.spawnSync('systemctl', [
            enabled ? 'enable' : 'disable',
            '--now',
            'systemd-sysupdate.timer',
        ]);
        return proc.status === 0;
    }
}

export default new LinuxWebThingsOSPlatform();
