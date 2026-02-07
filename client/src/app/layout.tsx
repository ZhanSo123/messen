import React from "react";

export default function RootLayout(props: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 24, fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Arial" }}>
        {props.children}
      </body>
    </html>
  );
}

