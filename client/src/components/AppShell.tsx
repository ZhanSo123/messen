"use client";

import { usePathname } from "next/navigation";
import React, { useEffect, useState } from "react";
import { BottomBubbleNav } from "./BottomBubbleNav";

function hideNav(pathname: string) {
  return pathname === "/login" || pathname === "/register" || pathname === "/onboarding";
}

export function AppShell(props: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const baseShow = !hideNav(pathname);
  const [keyboardHide, setKeyboardHide] = useState(false);

  useEffect(() => {
    // Minimal iOS Safari / touch-friendly behavior: hide fixed bottom nav while typing,
    // so it doesn't overlap inputs when the software keyboard is open.
    const isTouch = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    if (!isTouch) return;

    const shouldHideForTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName?.toLowerCase?.() ?? "";
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if (el.isContentEditable) return true;
      return false;
    };

    const onFocusIn = (e: FocusEvent) => {
      if (shouldHideForTarget(e.target)) setKeyboardHide(true);
    };
    const onFocusOut = () => {
      // Allow layout to settle after blur.
      setTimeout(() => setKeyboardHide(false), 120);
    };

    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("focusout", onFocusOut);
    return () => {
      window.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  const show = baseShow && !keyboardHide;

  return (
    <>
      <div className="nm-shell" data-nav={show ? "on" : "off"}>
        {props.children}
      </div>
      {show ? <BottomBubbleNav /> : null}
    </>
  );
}
