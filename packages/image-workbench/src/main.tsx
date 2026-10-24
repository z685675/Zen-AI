import './i18n'
import './style.css'
import '../../../src/renderer/src/assets/fonts/harmonyos/harmonyos.css'
import '../../../src/renderer/src/assets/fonts/ubuntu/ubuntu.css'
import '../../../src/renderer/src/assets/fonts/country-flag-fonts/flag.css'

import { createRoot } from 'react-dom/client'

import Workbench from './Workbench'

const appearance = new URLSearchParams(location.hash.slice(1))
document.documentElement.dataset.theme = appearance.get('theme') === 'dark' ? 'dark' : 'light'
document.body.setAttribute('os', appearance.get('os') || '')
const fontFamily = appearance.get('fontFamily')
if (fontFamily) document.documentElement.style.setProperty('--user-font-family', JSON.stringify(fontFamily))
createRoot(document.getElementById('root')!).render(<Workbench />)
