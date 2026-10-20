import { createContext, useContext, useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { GLOSSARY } from './glossary';

const Ctx = createContext<{ open: (k?: string) => void }>({ open: () => {} });

export function GlossaryProvider({ children }: { children: ReactNode }) {
  const [key, setKey] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const open = (k?: string) => {
    if (k) {
      setKey(k);
      setAll(false);
    } else {
      setKey(null);
      setAll(true);
    }
  };
  const item = key ? GLOSSARY[key] : null;
  return (
    <Ctx.Provider value={{ open }}>
      {children}
      <Sheet open={!!item} onClose={() => setKey(null)} title={item?.term ?? ''}>
        <p>{item?.text}</p>
        <button className="btn small" onClick={() => open()}>All terms</button>
      </Sheet>
      <Sheet open={all} onClose={() => setAll(false)} title="Glossary">
        <dl className="stack">
          {Object.entries(GLOSSARY).map(([k, g]) => (
            <div key={k}>
              <dt className="bold">{g.term}</dt>
              <dd className="muted small" style={{ margin: 0 }}>{g.text}</dd>
            </div>
          ))}
        </dl>
      </Sheet>
    </Ctx.Provider>
  );
}

export const useGlossary = () => useContext(Ctx).open;

/** Tap any term for a two-line explanation. */
export function Term({ k, children }: { k: keyof typeof GLOSSARY | string; children?: ReactNode }) {
  const open = useGlossary();
  return (
    <button type="button" className="term" onClick={() => open(k)}>
      {children ?? GLOSSARY[k]?.term ?? k}
    </button>
  );
}
