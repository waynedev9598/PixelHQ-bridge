import Bonjour from 'bonjour-service';
import { networkInterfaces } from 'os';
import { config } from './config.js';
import { logger } from './logger.js';

function getLocalIPv4(): string {
  const nets = networkInterfaces();

  const preferredInterfaces = ['en0', 'en1', 'eth0', 'wlan0'];

  for (const ifname of preferredInterfaces) {
    const net = nets[ifname];
    if (net) {
      for (const addr of net) {
        if (addr.family === 'IPv4' && !addr.internal) {
          return addr.address;
        }
      }
    }
  }

  for (const name of Object.keys(nets)) {
    for (const addr of nets[name]!) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }

  return '0.0.0.0';
}

/**
 * Advertises the bridge server via Bonjour/mDNS.
 * Allows iOS app to discover the bridge automatically.
 */
export class BonjourAdvertiser {
  private bonjour: InstanceType<typeof Bonjour.default> | null;
  private service: ReturnType<InstanceType<typeof Bonjour.default>['publish']> | null;
  private _localIP: string;

  constructor() {
    this.bonjour = null;
    this.service = null;
    this._localIP = '0.0.0.0';
  }

  get localIP(): string {
    return this._localIP;
  }

  start(): void {
    this.bonjour = new Bonjour.default();

    this._localIP = getLocalIPv4();

    this.service = this.bonjour.publish({
      name: config.bonjourName,
      type: config.bonjourType,
      port: config.wsPort,
      txt: {
        version: '1.0.0',
        protocol: 'websocket',
        ip: this._localIP,
        auth: 'required',
      },
    });

    this.service.on('up', () => {
      logger.verbose('Bonjour', `Service advertised: ${config.bonjourName}`);
      logger.verbose('Bonjour', `Type: _${config.bonjourType}._tcp`);
      logger.verbose('Bonjour', `Port: ${config.wsPort}`);
      logger.verbose('Bonjour', `IP: ${this._localIP}`);
    });

    this.service.on('error', (error: unknown) => {
      logger.error('Bonjour', `Service error: ${(error as Error).message}`);
    });
  }

  stop(): void {
    if (this.service) {
      this.service.stop?.();
      this.service = null;
    }

    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }

    logger.verbose('Bonjour', 'Service unpublished');
  }
}
