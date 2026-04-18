const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const projectRoot = path.join(__dirname, '..')
const buildDir = path.join(projectRoot, 'build')
const installerIconPath = path.join(buildDir, 'installer-icon.ico')
const sourceMap = new Map([
  [16, path.join(buildDir, 'icons', '16x16.png')],
  [32, path.join(buildDir, 'icons', '32x32.png')],
  [48, path.join(buildDir, 'icons', '48x48.png')],
  [64, path.join(buildDir, 'icons', '64x64.png')],
  [128, path.join(buildDir, 'icons', '128x128.png')],
  [256, path.join(buildDir, 'icons', '256x256.png')]
])

const background = { r: 0, g: 0, b: 0, alpha: 1 }

function createIco(pngBuffers, sizes) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngBuffers.length, 4)

  const entries = []
  let offset = 6 + pngBuffers.length * 16

  for (let i = 0; i < pngBuffers.length; i += 1) {
    const size = sizes[i]
    const data = pngBuffers[i]
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(entry)
  }

  return Buffer.concat([header, ...entries, ...pngBuffers])
}

async function recenterPng(filePath, size) {
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let weightedX = 0
  let weightedY = 0
  let totalWeight = 0

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const index = (y * info.width + x) * info.channels
      const r = data[index]
      const g = data[index + 1]
      const b = data[index + 2]
      const a = data[index + 3]
      const luminance = Math.max(r, g, b)

      if (a < 10 || luminance < 10) {
        continue
      }

      const weight = a * luminance
      weightedX += x * weight
      weightedY += y * weight
      totalWeight += weight
    }
  }

  const centroidX = totalWeight > 0 ? weightedX / totalWeight : (info.width - 1) / 2
  const centroidY = totalWeight > 0 ? weightedY / totalWeight : (info.height - 1) / 2
  const centerX = (size - 1) / 2
  const centerY = (size - 1) / 2

  // Installer icons look best when slightly biased upward from visual center.
  const targetX = centerX + 0.25
  const targetY = centerY - 0.2

  const left = Math.round(targetX - centroidX)
  const top = Math.round(targetY - centroidY)

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background
    }
  })
    .composite([{ input: await sharp(filePath).png().toBuffer(), left, top }])
    .png()
    .toBuffer()
}

async function main() {
  const sizes = [...sourceMap.keys()]
  const buffers = []

  for (const size of sizes) {
    const filePath = sourceMap.get(size)
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing icon source: ${filePath}`)
    }

    buffers.push(await recenterPng(filePath, size))
  }

  await fs.promises.writeFile(installerIconPath, createIco(buffers, sizes))
  console.log(`Built installer icon: ${installerIconPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
