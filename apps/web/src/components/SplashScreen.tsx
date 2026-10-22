import { useEffect, useState } from 'react';

export default function SplashScreen({ onFinished }: { onFinished: () => void }) {
  const [phase, setPhase] = useState<'symbol' | 'text' | 'exit'>('symbol');

  useEffect(() => {
    // Phase 1: Symbol animates in (600ms)
    // Phase 2: Text reveals (after 600ms, lasts 700ms)
    const textTimer = setTimeout(() => setPhase('text'), 600);
    // Phase 3: Exit fade (after 1700ms total)
    const exitTimer = setTimeout(() => setPhase('exit'), 1700);
    // Remove splash after exit animation (400ms)
    const doneTimer = setTimeout(() => onFinished(), 2100);
    return () => {
      clearTimeout(textTimer);
      clearTimeout(exitTimer);
      clearTimeout(doneTimer);
    };
  }, [onFinished]);

  return (
    <div className={`splash-screen ${phase === 'exit' ? 'splash-exit' : ''}`}>
      <div className="splash-content">
        <div className={`splash-symbol ${phase !== 'symbol' ? 'splash-symbol-settled' : ''}`}>
          <span className="splash-v">v</span>
          <span className="splash-dot" />
        </div>
        <div className={`splash-wordmark ${phase === 'text' || phase === 'exit' ? 'splash-wordmark-visible' : ''}`}>
          {'vidyalayaa'.split('').map((char, i) => (
            <span
              key={i}
              className="splash-letter"
              style={{ animationDelay: `${i * 50}ms` }}
            >
              {char}
            </span>
          ))}
          <span
            className="splash-letter splash-period"
            style={{ animationDelay: '500ms' }}
          >
            .
          </span>
        </div>
      </div>
      <p className={`splash-tagline ${phase === 'text' || phase === 'exit' ? 'splash-tagline-visible' : ''}`}>
        a connected school, a clearer day
      </p>
    </div>
  );
}
