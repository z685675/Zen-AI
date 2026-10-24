import { Button } from "antd";
import { useTranslation } from "react-i18next";
import { changeAppLocale } from "@/i18n";
import { useThemeStore } from "@/stores/use-theme-store";
export function UserStatusActions({ onOpenShortcuts }: { showConfig?: boolean; variant?: string; onOpenShortcuts?: () => void; onOpenPlugins?: () => void }) {
 const { i18n, t } = useTranslation();
 const { theme, setTheme } = useThemeStore();
 return <div style={{display:'flex',gap:4}}><Button type="text" onClick={() => void changeAppLocale(i18n.resolvedLanguage === 'zh-CN' ? 'en-US' : 'zh-CN')}>中/EN</Button><Button type="text" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{t(theme === 'dark' ? 'topNav.lightTheme' : 'topNav.darkTheme')}</Button>{onOpenShortcuts && <Button type="text" onClick={onOpenShortcuts}>{t('canvas.shortcuts')}</Button>}</div>;
}
