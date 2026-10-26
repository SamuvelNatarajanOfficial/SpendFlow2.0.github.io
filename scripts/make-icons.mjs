// Generates PNG icons from public/favicon.svg. Run: npm run icons
import sharp from 'sharp'
import { readFileSync } from 'node:fs'

const svg = readFileSync('public/favicon.svg')
await sharp(svg).resize(192, 192).png().toFile('public/icon-192.png')
await sharp(svg).resize(512, 512).png().toFile('public/icon-512.png')

// Maskable: full-bleed navy background, glyph kept inside the central safe zone.
const glyph = await sharp(svg).resize(360, 360).png().toBuffer()
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#0b1f3a' } })
  .composite([{ input: glyph, gravity: 'center' }])
  .png()
  .toFile('public/icon-maskable-512.png')
console.log('icons written')
