import type { Server } from 'node:net'

// Fetch's forbidden ports also apply to loopback URLs. The OS dynamic range
// is configurable and can include these ports, so listen(0) alone is not safe.
const blockedPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080
])

export function isFetchSafePort(port: number) {
  return Number.isInteger(port) && port > 0 && port <= 65535 && !blockedPorts.has(port)
}

/** Bind and keep the socket; never probe a free port then race another process. */
export async function listenOnLoopback(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 16; attempt++) {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        server.off('listening', ready)
        reject(error)
      }
      const ready = () => {
        server.off('error', failed)
        resolve()
      }
      server.once('error', failed)
      server.once('listening', ready)
      try {
        server.listen(0, '127.0.0.1')
      } catch (error) {
        server.off('error', failed)
        server.off('listening', ready)
        reject(error)
      }
    })
    const address = server.address()
    if (address && typeof address !== 'string' && isFetchSafePort(address.port)) return address.port
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
  throw new Error('Unable to allocate a Fetch-compatible loopback port after 16 attempts')
}
