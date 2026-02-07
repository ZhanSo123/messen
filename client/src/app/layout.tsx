import React from "react";
import "./globals.css";
import { AppShell } from "../components/AppShell";

export default function RootLayout(props: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="nm-page">
          <AppShell>{props.children}</AppShell>
        </div>
      </body>
    </html>
  );
}
