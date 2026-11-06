import { useRef, useState } from 'react';
import { ArrowUpRight, Copy, HelpCircle, Mail } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

const supportEmail = 'vidyalayaainfo@gmail.com';
const gmailCompose =
  'https://mail.google.com/mail/?' +
  new URLSearchParams({
    view: 'cm',
    fs: '1',
    to: supportEmail,
    su: 'Vidyalayaa support',
  });

export default function SupportContact({
  requestPath,
  onNavigate,
}: {
  requestPath?: string;
  onNavigate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const email = useRef<HTMLInputElement>(null);

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(supportEmail);
      setMessage('Support email copied.');
    } catch {
      email.current?.focus();
      email.current?.select();
      setMessage('Support email selected. You can copy it from the field.');
    }
  }

  return (
    <div className="support-card">
      <div className="support-circle">
        <HelpCircle size={19} aria-hidden="true" />
      </div>
      <h3>A little help goes a long way.</h3>
      <p>We’re here for your school.</p>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) setMessage('');
          setOpen(next);
        }}
        title="Contact Vidyalayaa support"
        description="Open a Gmail draft in your browser, or copy the address and use your email service."
        trigger={
          <button type="button" className="support-card-trigger">
            Let’s talk <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        }
      >
        <label className="block text-sm font-medium">
          Support email
          <input
            ref={email}
            className="input mt-2"
            value={supportEmail}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild variant="lime">
            <a href={gmailCompose} target="_blank" rel="noopener noreferrer">
              <Mail size={16} /> Open Gmail draft
            </a>
          </Button>
          <Button type="button" variant="outline" onClick={copyEmail}>
            <Copy size={16} /> Copy email
          </Button>
          {requestPath && (
            <Button asChild variant="outline">
              <Link
                to={requestPath}
                onClick={() => {
                  setOpen(false);
                  onNavigate();
                }}
              >
                Support requests
              </Link>
            </Button>
          )}
        </div>
        <div className="mt-3 min-h-5 text-sm text-stone-600" role="status">
          {message}
        </div>
      </Dialog>
    </div>
  );
}
