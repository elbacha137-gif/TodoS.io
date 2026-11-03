'use strict';

const os = require('node:os');
const dgram = require('node:dgram');

/** All non-internal IPv4 addresses, physical adapters first. */
function listIps() {
  const ips = [];
  for (const name of Object.keys(os.networkInterfaces())) {
    for (const net of os.networkInterfaces()[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }

  // Prefer normal home-network ranges, push virtual adapters (VirtualBox,
  // Hyper-V, WSL) to the end.
  const score = (ip) =>
    ip.startsWith('192.168.56.') || ip.startsWith('192.168.137.') ? 2 : ip.startsWith('192.168.') ? 0 : 1;

  return ips.sort((a, b) => score(a) - score(b));
}

/**
 * The address your PC actually uses to reach the internet.
 * Opening a UDP socket sends no packets — it just asks the OS for a route.
 */
function primaryIp() {
  return new Promise((resolve) => {
    let socket;
    const done = (value) => {
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };

    try {
      socket = dgram.createSocket('udp4');
      socket.on('error', () => done(listIps()[0] || 'localhost'));
      socket.connect(53, '8.8.8.8', () => {
        const address = socket.address().address;
        done(address && address !== '0.0.0.0' ? address : listIps()[0] || 'localhost');
      });
    } catch {
      done(listIps()[0] || 'localhost');
    }
  });
}

module.exports = { listIps, primaryIp };
