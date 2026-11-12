import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';
const variants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border border-action-line bg-action text-on-action hover:bg-action-hover',
        lime: 'bg-accent text-on-accent hover:bg-lime-600',
        outline: 'border border-control bg-surface text-ink hover:bg-stone-50',
        ghost: 'text-stone-600 hover:bg-stone-100',
        destructive: 'bg-red-700 text-on-danger hover:bg-danger-hover',
      },
      size: { default: 'h-11 px-4', sm: 'h-9 px-3 text-xs', icon: 'size-10' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);
export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof variants> {
  asChild?: boolean;
}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp ref={ref} className={cn(variants({ variant, size, className }))} {...props} />;
  },
);
Button.displayName = 'Button';
