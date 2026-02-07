"use client";

import { usePathname } from "next/navigation";
import React from "react";
import { BottomBubbleNav } from "./BottomBubbleNav";

function hideNav(pathname: string) {
  return pathname === "/login" || pathname === "/register" || pathname === "/onboarding";
}

export function AppShell(props: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const show = !hideNav(pathname);

  return (
    <>
      <div style={{ paddingBottom: show ? 110 : 0 }}>{props.children}</div>
      {show ? <BottomBubbleNav /> : null}
    </>
  );
}

