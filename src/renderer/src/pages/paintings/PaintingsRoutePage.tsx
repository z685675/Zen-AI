import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'

import ImageCanvasPage from './ImageCanvasPage'

export default function PaintingsRoutePage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      <Navbar>
        <NavbarCenter />
      </Navbar>
      <ImageCanvasPage />
    </div>
  )
}
