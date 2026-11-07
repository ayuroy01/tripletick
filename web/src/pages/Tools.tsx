import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { PageHead, useApp } from '../lib/ui';

const toBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function Notifications() {
  const { toast } = useApp();
  const supported = 'serviceWorker' in navigator && 'PushManager' in window;
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (supported) navigator.serviceWorker.getRegistration().then((r) => r?.pushManager.getSubscription()).then((s) => setOn(!!s)).catch(() => {});
  }, [supported]);

  const toggle = async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const current = await reg.pushManager.getSubscription();
      if (current) {
        await api.post('/push/unsubscribe', { endpoint: current.endpoint });
        await current.unsubscribe();
        return setOn(false);
      }
      if ((await Notification.requestPermission()) !== 'granted') return toast('Notifications are blocked in your browser settings', 'error');
      const { publicKey } = await api.get('/push/key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(publicKey) });
      await api.post('/push/subscribe', sub.toJSON());
      setOn(true);
      toast('Notifications are on');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <section className="card form">
      <h3>Install on your phone or desktop</h3>
      <p className="muted small">On iPhone: Share, then Add to Home Screen. On Android or desktop: use the browser's Install option. It then opens like a normal app.</p>
      {supported
        ? <button className="btn small" onClick={toggle}>{on ? '🔕 Turn off notifications' : '🔔 Turn on notifications'}</button>
        : <p className="muted small">This browser doesn't support notifications. On iPhone, install the app first.</p>}
      <p className="muted small">Notifications show who messaged, never what they said.</p>
    </section>
  );
}

export function Tools() {
  const { toast } = useApp();
  const [phone, setPhone] = useState('15550100');
  const [text, setText] = useState('Hi! I would like to know more.');
  const canvas = useRef<HTMLCanvasElement>(null);
  const digits = phone.replace(/\D/g, '');
  const link = `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
  const snippet = `<a href="${link}" target="_blank" rel="noopener"\n   style="position:fixed;right:20px;bottom:20px;background:#6d28d9;color:#fff;\n   padding:12px 18px;border-radius:999px;font-family:sans-serif;text-decoration:none">\n  Chat with us\n</a>`;

  useEffect(() => {
    if (canvas.current && digits) QRCode.toCanvas(canvas.current, link, { width: 240, margin: 2 }).catch(() => {});
  }, [link, digits]);

  const copy = (s: string) => { navigator.clipboard.writeText(s); toast('Copied'); };

  return (
    <div className="page">
      <PageHead title="Tools" sub="Free growth helpers. No sign-up walls." />
      <div className="grid-2">
        <section className="card form">
          <h3>Chat link and QR code</h3>
          <label>Your WhatsApp number<input value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
          <label>Pre-filled message<textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} /></label>
          <pre className="snippet">{link}</pre>
          <button className="btn small" onClick={() => copy(link)}>Copy link</button>
        </section>
        <section className="card qr">
          <canvas ref={canvas} aria-label="QR code for your chat link" />
          <button className="btn small" onClick={() => {
            const a = document.createElement('a');
            a.href = canvas.current!.toDataURL('image/png');
            a.download = 'triple-tick-qr.png';
            a.click();
          }}>Download PNG</button>
        </section>
      </div>
      <Notifications />
      <section className="card form">
        <h3>Website chat button</h3>
        <pre className="snippet">{snippet}</pre>
        <button className="btn small" onClick={() => copy(snippet)}>Copy snippet</button>
      </section>
      <section className="card form">
        <h3>Embed in your CRM</h3>
        <p className="muted small">Open any chat in a frame with the navigation hidden. Host Triple Tick on the same site as your CRM (a subdomain works), because browsers won't send the sign-in cookie to a frame on a different site.</p>
        <pre className="snippet">{`<iframe src="${location.origin}/#/inbox/CHAT_ID?embed=1" width="100%" height="700"></iframe>`}</pre>
      </section>
    </div>
  );
}
