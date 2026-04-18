const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const projectRoot = path.join(__dirname, '..')
const defaultSource = path.join(projectRoot, 'build', 'icon.png')
const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : defaultSource

const background = { r: 0, g: 0, b: 0, alpha: 1 }
const appPaddingBySize = new Map([
  [1024, 0.11],
  [512, 0.115],
  [256, 0.125],
  [128, 0.14],
  [64, 0.16],
  [48, 0.175],
  [32, 0.2],
  [24, 0.22],
  [16, 0.245]
])

const trayPaddingBySize = new Map([
  [64, 0.19],
  [32, 0.215],
  [16, 0.24]
])

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function getInnerSize(size, paddingMap) {
  const padding = paddingMap.get(size) ?? 0.1
  return Math.max(1, Math.round(size * (1 - padding * 2)))
}

async function cropSourceToContent(source) {
  const threshold = 18
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const channels = info.channels

  let minX = info.width
  let minY = info.height
  let maxX = -1
  let maxY = -1
  let weightedX = 0
  let weightedY = 0
  let totalWeight = 0

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const index = (y * info.width + x) * channels
      const r = data[index]
      const g = data[index + 1]
      const b = data[index + 2]
      const a = data[index + 3]

      if (a < threshold) {
        continue
      }

      if (Math.max(r, g, b) < threshold) {
        continue
      }

      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)

      const weight = a * Math.max(r, g, b)
      weightedX += x * weight
      weightedY += y * weight
      totalWeight += weight
    }
  }

  if (maxX < minX || maxY < minY) {
    const fallback = await sharp(source).png().toBuffer()
    const metadata = await sharp(fallback).metadata()
    return {
      buffer: fallback,
      width: metadata.width,
      height: metadata.height,
      centroidX: metadata.width / 2,
      centroidY: metadata.height / 2
    }
  }

  const contentWidth = maxX - minX + 1
  const contentHeight = maxY - minY + 1
  const marginX = Math.round(contentWidth * 0.04)
  const marginY = Math.round(contentHeight * 0.04)

  const left = Math.max(0, minX - marginX)
  const top = Math.max(0, minY - marginY)
  const width = Math.min(info.width - left, contentWidth + marginX * 2)
  const height = Math.min(info.height - top, contentHeight + marginY * 2)

  const buffer = await sharp(source)
    .extract({
      left,
      top,
      width,
      height
    })
    .png()
    .toBuffer()

  const centroidX = totalWeight > 0 ? weightedX / totalWeight - left : width / 2
  const centroidY = totalWeight > 0 ? weightedY / totalWeight - top : height / 2

  return {
    buffer,
    width,
    height,
    centroidX,
    centroidY
  }
}

async function buildSquarePng(source, size, paddingMap) {
  const innerSize = getInnerSize(size, paddingMap)
  const { data: resizedBuffer, info } = await sharp(source.buffer)
    .resize({
      width: innerSize,
      height: innerSize,
      fit: 'inside',
      kernel: sharp.kernel.lanczos3
    })
    .png()
    .toBuffer({ resolveWithObject: true })

  const scale = Math.min(info.width / source.width, info.height / source.height)
  const centroidX = source.centroidX * scale
  const centroidY = source.centroidY * scale
  const maxLeft = size - info.width
  const maxTop = size - info.height

  const left = Math.max(0, Math.min(Math.round(size / 2 - centroidX), maxLeft))
  const top = Math.max(0, Math.min(Math.round(size / 2 - centroidY), maxTop))

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background
    }
  })
    .composite([{ input: resizedBuffer, left, top }])
    .png()
    .toBuffer()
}

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

async function writeFile(filePath, buffer) {
  ensureDir(filePath)
  await fs.promises.writeFile(filePath, buffer)
}

async function main() {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source image not found: ${sourcePath}`)
  }

  const squareSource = await cropSourceToContent(sourcePath)
  const appSizes = [1024, 512, 256, 128, 64, 48, 32, 24, 16]
  const buildIconsDir = path.join(projectRoot, 'build', 'icons')

  const generatedAppBuffers = new Map()
  for (const size of appSizes) {
    generatedAppBuffers.set(size, await buildSquarePng(squareSource, size, appPaddingBySize))
  }

  await writeFile(path.join(projectRoot, 'build', 'icon.png'), generatedAppBuffers.get(1024))
  await writeFile(path.join(projectRoot, 'build', 'logo.png'), generatedAppBuffers.get(1024))
  await writeFile(path.join(projectRoot, 'src', 'renderer', 'src', 'assets', 'images', 'zen-logo.png'), generatedAppBuffers.get(1024))
  await writeFile(path.join(projectRoot, 'src', 'renderer', 'src', 'assets', 'images', 'logo.png'), generatedAppBuffers.get(1024))

  for (const size of appSizes) {
    await writeFile(path.join(buildIconsDir, `${size}x${size}.png`), generatedAppBuffers.get(size))
  }

  const icoSizes = [16, 24, 32, 48, 64, 128, 256]
  const icoBuffers = icoSizes.map((size) => generatedAppBuffers.get(size))
  await writeFile(path.join(projectRoot, 'build', 'icon.ico'), createIco(icoBuffers, icoSizes))

  const trayBuffer = await buildSquarePng(squareSource, 64, trayPaddingBySize)
  await writeFile(path.join(projectRoot, 'build', 'tray_icon.png'), trayBuffer)
  await writeFile(path.join(projectRoot, 'build', 'tray_icon_dark.png'), trayBuffer)
  await writeFile(path.join(projectRoot, 'build', 'tray_icon_light.png'), trayBuffer)

  console.log(`Generated Zen AI icons from ${sourcePath}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
