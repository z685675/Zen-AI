import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import '../../../src/renderer/src/assets/fonts/harmonyos/harmonyos.css';
import '../../../src/renderer/src/assets/fonts/ubuntu/ubuntu.css';
import '../../../src/renderer/src/assets/fonts/country-flag-fonts/flag.css';
import { RouterProvider } from "react-router-dom";

import { AppProviders } from "@/components/layout/app-providers";
import "@/i18n";
import { initAnalytics } from "@/lib/analytics";
import { router } from "@/router";

initAnalytics();

const appearance = new URLSearchParams(location.hash.slice(1));
document.body.setAttribute('os', appearance.get('os') || '');
const fontFamily = appearance.get('fontFamily');
if (fontFamily) document.documentElement.style.setProperty('--user-font-family', JSON.stringify(fontFamily));

createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <AppProviders>
            <RouterProvider router={router} />
        </AppProviders>
    </React.StrictMode>,
);
