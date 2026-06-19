const fs = require('fs')
const path = require('path')

const projectRoot = path.join(__dirname, '..')
const buildDir = path.join(projectRoot, 'build')
const iconsDir = path.join(buildDir, 'icons')
const outputPaths = [path.join(buildDir, 'icon.ico'), path.join(buildDir, 'installer-icon.ico')]
const sizes = [16, 24, 32, 48, 64, 128, 256]

function createIco(pngBuffers, iconSizes) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngBuffers.length, 4)

  const entries = []
  let offset = 6 + pngBuffers.length * 16

  for (let index = 0; index < pngBuffers.length; index += 1) {
    const size = iconSizes[index]
    const data = pngBuffers[index]
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

function main() {
  const buffers = sizes.map((size) => {
    const filePath = path.join(iconsDir, `${size}x${size}.png`)

    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing Windows icon source: ${filePath}`)
    }

    return fs.readFileSync(filePath)
  })
  const ico = createIco(buffers, sizes)

  for (const outputPath of outputPaths) {
    fs.writeFileSync(outputPath, ico)
    console.log(`Built Windows icon: ${outputPath}`)
  }
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
