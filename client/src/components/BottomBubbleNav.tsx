"use client";

import { usePathname, useRouter } from "next/navigation";
import React, { useMemo } from "react";

type Item = {
  key: string;
  label: string;
  href: string;
  icon: React.ReactNode;
  isActive: (pathname: string) => boolean;
};

function IconHome() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 10.5 12 4l8 6.5V20a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 20v-9.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9.5 21.5v-7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v7" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function IconFeed() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 7h10M7 12h10M7 17h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M5.5 4.5h13A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18V6a1.5 1.5 0 0 1 1.5-1.5Z" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M10.5 18.5a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z" stroke="currentColor" strokeWidth="1.6" />
      <path d="M16.5 16.5 21 21" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M19.4 13.5a7.9 7.9 0 0 0 0-3l2-1.2-2-3.4-2.3.6a8.4 8.4 0 0 0-2.6-1.5L14 2h-4l-.5 3A8.4 8.4 0 0 0 6.9 6.5L4.6 5.9l-2 3.4 2 1.2a7.9 7.9 0 0 0 0 3l-2 1.2 2 3.4 2.3-.6a8.4 8.4 0 0 0 2.6 1.5l.5 3h4l.5-3a8.4 8.4 0 0 0 2.6-1.5l2.3.6 2-3.4-2-1.2Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        opacity="0.9"
      />
    </svg>
  );
}

export function BottomBubbleNav() {
  const pathname = usePathname() ?? "/";
  const router = useRouter();

  const items: Item[] = useMemo(
    () => [
      { key: "focus", label: "Focus", href: "/", icon: <IconHome />, isActive: (p) => p === "/" || p.startsWith("/chat/") },
      { key: "feed", label: "Feed", href: "/feed", icon: <IconFeed />, isActive: (p) => p === "/feed" },
      { key: "search", label: "Search", href: "/search", icon: <IconSearch />, isActive: (p) => p === "/search" },
      { key: "settings", label: "Settings", href: "/settings", icon: <IconSettings />, isActive: (p) => p === "/settings" }
    ],
    []
  );

  return (
    <div className="nm-bubble-wrap" role="navigation" aria-label="Bottom navigation">
      <div className="nm-bubble">
        {items.map((it) => {
          const active = it.isActive(pathname);
          return (
            <button
              key={it.key}
              className={`nm-bubble-btn${active ? " is-active" : ""}`}
              onClick={() => router.push(it.href)}
              aria-label={it.label}
              aria-current={active ? "page" : undefined}
              type="button"
            >
              <span className="nm-bubble-icon">{it.icon}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

