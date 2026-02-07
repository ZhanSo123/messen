"use client";

function key(meId: string) {
  return `nm:onboarded:${meId}`;
}

export function isOnboarded(meId: string): boolean {
  try {
    return localStorage.getItem(key(meId)) === "true";
  } catch {
    return false;
  }
}

export function setOnboarded(meId: string) {
  localStorage.setItem(key(meId), "true");
}

