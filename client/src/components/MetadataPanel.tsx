'use client';

import { useAether } from '@/context/AetherContext';
import { useMetadataPanel } from '@/context/MetadataPanelContext';
import { useHashParams } from '@/hooks/useHashParams';

export function MetadataPanel() {
  const { isOpen, toggle } = useMetadataPanel();
  const { isReady, peerCount } = useAether();
  const hashParams = useHashParams();
  const boardId = hashParams.get('board') || 'vip';
  const threadId = hashParams.get('thread');

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div 
          className="fixed inset-0 z-[80] bg-[rgba(45,52,51,0.05)]" 
          onClick={toggle}
        />
      )}

      {/* Slide Panel */}
      <div
        className={`fixed top-12 right-0 bottom-0 w-80 z-[90] bg-[#F2F4F3]/95 backdrop-blur-xl border-l-[0.5px] border-[rgba(173,179,178,0.15)] flex flex-col transform transition-transform duration-300 ease-in-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="p-8 flex flex-col gap-8 overflow-y-auto flex-1 font-['Space_Grotesk']">
          {/* Close button */}
          <div className="flex justify-between items-center">
            <h2 className="text-[9px] font-bold uppercase tracking-[0.3em] text-[rgba(45,52,51,0.6)]">SYSTEM_METRICS</h2>
            <button 
              onClick={toggle} 
              className="text-[11px] font-['Space_Mono'] text-[rgba(45,52,51,0.4)] hover:text-[#4A90E2] transition-colors"
            >
              CLOSE ✕
            </button>
          </div>

          {/* NETWORK_STATUS */}
          <section>
            <h3 className="text-[9px] font-bold uppercase tracking-[0.3em] text-[rgba(45,52,51,0.6)] mb-6 flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-[#4A90E2] rounded-full"></span> NETWORK_STATUS
            </h3>
            <div className="space-y-4">
              <div className="border-[0.5px] border-[rgba(173,179,178,0.15)] p-4 bg-white">
                <div className="flex justify-between items-center mb-2">
                  <span className="font-['Space_Mono'] text-[9px] uppercase text-[rgba(45,52,51,0.6)]">Sync Load</span>
                  <span className="font-['Space_Mono'] text-[11px] font-bold text-[#4A90E2]">{isReady ? '100%' : 'BUSY'}</span>
                </div>
                <div className="w-full h-[1px] bg-[rgba(173,179,178,0.15)] relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0 bg-[#4A90E2] transition-all duration-1000" style={{ width: isReady ? '100%' : '30%' }}></div>
                </div>
              </div>
              <div className="border-[0.5px] border-[rgba(173,179,178,0.15)] p-4 bg-white">
                <div className="flex justify-between items-center mb-1">
                  <span className="font-['Space_Mono'] text-[9px] uppercase text-[rgba(45,52,51,0.6)]">Peer Density</span>
                  <span className="font-['Space_Mono'] text-[11px] font-bold">{peerCount} NODES</span>
                </div>
                <span className="font-['Space_Mono'] text-[9px] text-[#4A90E2]">STATUS: {isReady ? 'NOMINAL' : 'STREAMING'}</span>
              </div>
            </div>
          </section>

          {/* ARCHIVE_METADATA */}
          <section>
            <h3 className="text-[9px] font-bold uppercase tracking-[0.3em] text-[rgba(45,52,51,0.6)] mb-6">ARCHIVE_METADATA</h3>
            <div className="border-[0.5px] border-[rgba(173,179,178,0.15)] bg-white">
              <table className="w-full text-left font-['Space_Mono'] text-[9px]">
                <tbody>
                  <tr className="border-b-[0.5px] border-[rgba(173,179,178,0.15)]">
                    <td className="p-4 text-[rgba(45,52,51,0.6)]">ZONE_ID</td>
                    <td className="p-4 font-bold truncate max-w-[100px]">{boardId}</td>
                  </tr>
                  {threadId && (
                    <tr className="border-b-[0.5px] border-[rgba(173,179,178,0.15)]">
                      <td className="p-4 text-[rgba(45,52,51,0.6)]">TOPIC</td>
                      <td className="p-4 truncate max-w-[100px]">{threadId}</td>
                    </tr>
                  )}
                  <tr className="border-b-[0.5px] border-[rgba(173,179,178,0.15)]">
                    <td className="p-4 text-[rgba(45,52,51,0.6)]">PHASE</td>
                    <td className="p-4 text-[#4A90E2]">{isReady ? 'SYNCHRONIZED' : 'BUFFERING'}</td>
                  </tr>
                  <tr>
                    <td className="p-4 text-[rgba(45,52,51,0.6)]">ROUTING</td>
                    <td className="p-4">FRAGMENT_ONLY</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* Protocol Info */}
          <div className="mt-auto p-4 bg-[rgba(74,144,226,0.1)] border-[0.5px] border-[rgba(74,144,226,0.2)]">
            <h4 className="font-['Space_Mono'] text-[9px] font-bold text-[#4A90E2] mb-2 uppercase">Protocol Note</h4>
            <p className="text-[11px] leading-[1.6] text-[rgba(45,52,51,0.6)]">
              All parameters are routed via URL fragments. 
              No metadata leaves the browser context.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
