/**
 * PairingDialog - Shows a QR code for Aeronaut to scan and pair, plus the
 * paired-devices list and "Create device token" (contracts §4.2, §9.1).
 *
 * The QR now carries a single-use ticket instead of the shared token
 * (`POST /pair/redeem` exchanges it for a per-device token); this dialog
 * stays tolerant of the older token-bearing shape (pairVersion 1) until
 * lee-core's `issueQrTicket()` is merged.
 */

import React, { useEffect, useState } from 'react';
import { DevicesList } from './copilot/DevicesList';

const lee = window.lee;

interface PairingDialogProps {
  onClose: () => void;
}

interface PairingInfo {
  name: string;
  host: string;
  hostPort: number;
  /** Alias of hostPort, added for forward compatibility - same value. */
  apiPort?: number;
  hesterPort: number;
  /** pairVersion 2: single-use ticket, no token in the QR. */
  ticket?: string;
  ticketExpiresIn?: number;
  pairVersion?: number;
  /** pairVersion 1 (pre lee-core merge): the shared token, shown until issueQrTicket() lands. */
  token?: string;
}

export const PairingDialog: React.FC<PairingDialogProps> = ({ onClose }) => {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pairingInfo, setPairingInfo] = useState<PairingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    lee.aeronaut.getPairingQR()
      .then((result: { qrDataUrl: string; pairingInfo: PairingInfo }) => {
        setQrDataUrl(result.qrDataUrl);
        setPairingInfo(result.pairingInfo);
        if (result.pairingInfo.ticketExpiresIn != null) {
          setSecondsLeft(result.pairingInfo.ticketExpiresIn);
        }
      })
      .catch((err: Error) => {
        setError(err.message || 'Failed to generate QR code');
      });
  }, []);

  // Tick the ticket's expiry countdown.
  useEffect(() => {
    if (secondsLeft == null) return;
    if (secondsLeft <= 0) return;
    const timer = setInterval(() => {
      setSecondsLeft((s) => (s == null ? s : Math.max(0, s - 1)));
    }, 1000);
    return () => clearInterval(timer);
  }, [secondsLeft != null]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const isTicketBased = !!pairingInfo?.ticket;
  const copilotApi = lee.copilot;

  return (
    <div className="pairing-dialog-overlay" onClick={onClose}>
      <div className="pairing-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="pairing-dialog-header">
          <span className="pairing-dialog-title">Aeronaut Pairing</span>
          <button className="pairing-dialog-close" onClick={onClose}>&times;</button>
        </div>

        <div className="pairing-dialog-body">
          {error && (
            <div className="pairing-dialog-error">{error}</div>
          )}

          {!error && !qrDataUrl && (
            <div className="pairing-dialog-loading">Generating QR code...</div>
          )}

          {qrDataUrl && (
            <div className="pairing-dialog-qr">
              <img src={qrDataUrl} alt="Pairing QR code" width={280} height={280} />
            </div>
          )}

          {isTicketBased && secondsLeft != null && (
            <div className={`copilot-ticket-expiry${secondsLeft <= 60 ? ' is-expiring' : ''}`}>
              {secondsLeft > 0 ? `Expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}` : 'Expired — reopen to get a new code'}
            </div>
          )}

          {pairingInfo && (
            <div className="pairing-dialog-info">
              <p className="pairing-dialog-hint">
                Scan with Aeronaut to connect{isTicketBased ? '' : ', or enter manually:'}
              </p>
              {!isTicketBased && (
                <div className="pairing-dialog-details">
                  <div className="pairing-detail-row">
                    <span className="pairing-detail-label">Host</span>
                    <span className="pairing-detail-value">{pairingInfo.host}</span>
                  </div>
                  <div className="pairing-detail-row">
                    <span className="pairing-detail-label">Host Port</span>
                    <span className="pairing-detail-value">{pairingInfo.hostPort}</span>
                  </div>
                  <div className="pairing-detail-row">
                    <span className="pairing-detail-label">Hester Port</span>
                    <span className="pairing-detail-value">{pairingInfo.hesterPort}</span>
                  </div>
                  {pairingInfo.token && (
                    <div className="pairing-detail-row">
                      <span className="pairing-detail-label">Token</span>
                      <span className="pairing-detail-value pairing-detail-token">{pairingInfo.token}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {copilotApi && <DevicesList api={copilotApi} />}
        </div>
      </div>
    </div>
  );
};
