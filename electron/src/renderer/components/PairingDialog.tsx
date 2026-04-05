/**
 * PairingDialog - Shows a QR code for Aeronaut to scan and pair.
 *
 * Displays connection info (host, ports, token) so the mobile app
 * can connect to this Lee instance over the local network.
 */

import React, { useEffect, useState } from 'react';

const lee = (window as any).lee;

interface PairingDialogProps {
  onClose: () => void;
}

interface PairingInfo {
  name: string;
  host: string;
  hostPort: number;
  hesterPort: number;
  token: string;
}

export const PairingDialog: React.FC<PairingDialogProps> = ({ onClose }) => {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pairingInfo, setPairingInfo] = useState<PairingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    lee.aeronaut.getPairingQR()
      .then((result: { qrDataUrl: string; pairingInfo: PairingInfo }) => {
        setQrDataUrl(result.qrDataUrl);
        setPairingInfo(result.pairingInfo);
      })
      .catch((err: Error) => {
        setError(err.message || 'Failed to generate QR code');
      });
  }, []);

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

          {pairingInfo && (
            <div className="pairing-dialog-info">
              <p className="pairing-dialog-hint">
                Scan with Aeronaut to connect, or enter manually:
              </p>
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
                <div className="pairing-detail-row">
                  <span className="pairing-detail-label">Token</span>
                  <span className="pairing-detail-value pairing-detail-token">{pairingInfo.token}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
