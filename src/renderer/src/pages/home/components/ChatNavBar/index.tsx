import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import SearchPopup from '@renderer/components/Popups/SearchPopup'
import { useShortcut } from '@renderer/hooks/useShortcuts'

export default function ChatNavbar() {
  useShortcut('search_message', () => {
    void SearchPopup.show()
  })

  return (
    <Navbar>
      <NavbarCenter />
    </Navbar>
  )
}
