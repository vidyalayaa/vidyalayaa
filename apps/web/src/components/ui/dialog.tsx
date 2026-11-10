import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  trigger,
  dismissible = true,
  size = 'wide',
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  trigger?: ReactNode;
  dismissible?: boolean;
  size?: 'wide' | 'compact';
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-sm" />
        <DialogPrimitive.Content
          className={`dialog-content fixed left-1/2 top-1/2 z-50 flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ${size === 'wide' ? 'lg:max-w-5xl xl:max-w-6xl' : ''}`}
          onEscapeKeyDown={dismissible ? undefined : (event) => event.preventDefault()}
          onInteractOutside={dismissible ? undefined : (event) => event.preventDefault()}
        >
          <div className="flex shrink-0 items-start gap-3 p-4 sm:p-6">
            <div className="min-w-0 flex-1 break-words">
              <DialogPrimitive.Title className="text-xl font-semibold tracking-tight">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-2 text-sm text-stone-500">
                {description ||
                  'Complete the details below. Changes are saved securely to your school.'}
              </DialogPrimitive.Description>
            </div>
            {dismissible && (
              <DialogPrimitive.Close
                className="shrink-0 rounded-lg p-2 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-700"
                aria-label="Close dialog"
              >
                <X size={18} />
              </DialogPrimitive.Close>
            )}
          </div>
          <div className="dialog-body min-h-0 overflow-y-auto px-4 pb-4 sm:px-6 sm:pb-6">
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
