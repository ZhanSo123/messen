import React from "react";
import "./globals.css";
import { AppShell } from "../components/AppShell";

export default function RootLayout(props: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="nm-page">
          <div className="nm-content">
            <AppShell>{props.children}</AppShell>
          </div>
        </div>
      </body>
    </html>
  );
}
