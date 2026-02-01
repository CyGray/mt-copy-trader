// Animation utility classes and helpers
// Use these Tailwind classes throughout the app for consistent animations

export const animations = {
  // Fade animations
  fadeIn: 'animate-fade-in',
  
  // Slide animations
  slideUp: 'animate-slide-up',
  
  // Pulse for attention
  pulse: 'animate-pulse-slow',
  
  // Shake for errors
  shake: 'animate-shake',
  
  // Hover effects
  hoverScale: 'transition-transform duration-150 hover:scale-105 active:scale-95',
  hoverLift: 'transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md',
  
  // Focus effects
  focusRing: 'focus:outline-none focus:ring-2 focus:ring-marine-accent/30 focus:ring-offset-2',
  
  // Transition presets
  transitionFast: 'transition-all duration-150 ease-out',
  transitionBase: 'transition-all duration-300 ease-in-out',
  transitionSlow: 'transition-all duration-500 ease-in-out',
};

// Utility for combining animation classes
export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

// Skeleton loading styles
export const skeleton = {
  base: 'animate-pulse bg-marine-navy/10 rounded',
  text: 'h-4 w-full animate-pulse bg-marine-navy/10 rounded',
  card: 'h-24 w-full animate-pulse bg-marine-navy/10 rounded-xl',
  avatar: 'h-10 w-10 animate-pulse bg-marine-navy/10 rounded-full',
};

// Stagger animation helper (for lists)
export function getStaggerDelay(index: number, baseDelay = 50): string {
  return `${index * baseDelay}ms`;
}
