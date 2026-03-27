'use client';

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

interface MetadataPanelContextType {
  isOpen: boolean;
  toggle: () => void;
}

const MetadataPanelContext = createContext<MetadataPanelContextType>({
  isOpen: false,
  toggle: () => {},
});

export function MetadataPanelProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const toggle = useCallback(() => setIsOpen(prev => !prev), []);

  return (
    <MetadataPanelContext.Provider value={{ isOpen, toggle }}>
      {children}
    </MetadataPanelContext.Provider>
  );
}

export function useMetadataPanel() {
  return useContext(MetadataPanelContext);
}
