const fs = require('fs')
const path = require('path')

const projectRoot = path.join(__dirname, '..')
const buildDir = path.join(projectRoot, 'build')
const iconsDir = path.join(buildDir, 'icons')
const outputPath = path.join(buildDir, 'icon.icns')

const sourceMap = [
  ['ic11', '32x32.png'],
  ['ic12', '64x64.png'],
  ['ic07', '128x128.png'],
  ['ic08', '256x256.png'],
  ['ic13', '256x256.png'],
  ['ic09', '512x512.png'],
  ['ic14', '512x512.png'],
  ['ic10', '1024x1024.png']
]

function createIcnsChunk(type, data) {
  const chunk = Buffer.alloc(8 + data.length)
  chunk.write(type, 0, 4, 'ascii')
  chunk.writeUInt32BE(chunk.length, 4)
  data.copy(chunk, 8)
  return chunk
}

function main() {
  const chunks = sourceMap.map(([type, fileName]) => {
    const filePath = path.join(iconsDir, fileName)

    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing macOS icon source: ${filePath}`)
    }

    return createIcnsChunk(type, fs.readFileSync(filePath))
  })
  const length = 8 + chunks.reduce((total, chunk) => total + chunk.length, 0)
  const header = Buffer.alloc(8)

  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(length, 4)
  fs.writeFileSync(outputPath, Buffer.concat([header, ...chunks], length))

  console.log(`Built mac icon: ${outputPath}`)
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
