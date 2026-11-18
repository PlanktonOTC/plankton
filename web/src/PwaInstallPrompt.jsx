import { useEffect, useState } from 'react';
import { useI18n } from './i18n';
import './pwa-install.css';

const DISMISSED_KEY = 'plankton:pwa-install-dismissed';
const DISMISS_MS = 7 * 24 * 60 * 60 * 1000;

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function wasDismissed() {
  try {
    return Number(localStorage.getItem(DISMISSED_KEY)) > Date.now() - DISMISS_MS;
  } catch {
    return false;
  }
}

export default function PwaInstallPrompt() {
  const { t } = useI18n();
  const [installEvent, setInstallEvent] = useState(null);
  const [visible, setVisible] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent || '';
    const appleMobile = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    setIos(appleMobile);
    if (isStandalone() || wasDismissed()) return;

    const onPrompt = (event) => {
      event.preventDefault();
      setInstallEvent(event);
      setVisible(true);
    };
    const onInstalled = () => setVisible(false);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    if (appleMobile) setVisible(true);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(DISMISSED_KEY, String(Date.now())); } catch { /* storage may be unavailable */ }
    setVisible(false);
  };

  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    const choice = await installEvent.userChoice;
    setInstallEvent(null);
    if (choice.outcome === 'accepted') setVisible(false);
    else dismiss();
  };

  if (!visible || isStandalone()) return null;
  return (
    <aside className="pwa-install" aria-label={t('Install Plankton')}>
      <div className="pwa-install-copy">
        <strong>{t('Install Plankton')}</strong>
        <span>{ios ? t('On iPhone or iPad, tap Share, then Add to Home Screen.') : t('Add Plankton to your phone home screen for quick access.')}</span>
      </div>
      {!ios && <button type="button" onClick={install} disabled={!installEvent}>{t('Install')}</button>}
      <button className="pwa-install-dismiss" type="button" onClick={dismiss} aria-label={t('Dismiss install suggestion')}>×</button>
    </aside>
  );
}
