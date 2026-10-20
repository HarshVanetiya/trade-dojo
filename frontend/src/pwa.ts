import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as BeforeInstallPromptEvent;
  listeners.forEach((f) => f());
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  listeners.forEach((f) => f());
});

export function useInstallPrompt() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  const installed = matchMedia('(display-mode: standalone)').matches;
  return {
    canInstall: !!deferred,
    installed,
    prompt: async () => {
      if (!deferred) return;
      await deferred.prompt();
      deferred = null;
      listeners.forEach((fn) => fn());
    },
  };
}

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
