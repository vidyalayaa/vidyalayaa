import { useEffect, useRef, useState } from 'react';
import { NfcSerialReader, ReaderTimeoutError, serialAccess } from './nfc-serial';

export function useNfcReader(purpose: 'scan' | 'setup' = 'scan') {
  const reader = useRef<NfcSerialReader | null>(null);
  const mounted = useRef(false);
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [error, setError] = useState('');
  const [diagnostics, setDiagnostics] = useState('');

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void reader.current?.close();
      reader.current = null;
    };
  }, []);

  async function connect() {
    const serial = serialAccess();
    if (!serial) return;
    setStatus('connecting');
    setError('');
    setDiagnostics('');
    try {
      const port = await serial.requestPort();
      await port.open({ baudRate: 115200 });
      if (!mounted.current) {
        await port.close();
        return;
      }
      let device: NfcSerialReader;
      try {
        // Match the serial control settings used by the ESP32 provisioning helper.
        if (purpose === 'setup')
          await port.setSignals?.({ dataTerminalReady: true, requestToSend: true });
        if (!mounted.current) {
          await port.close();
          return;
        }
        device = new NfcSerialReader(port, () => {
          if (reader.current !== device) return;
          reader.current = null;
          setStatus('disconnected');
          setError('USB reader disconnected. Reconnect it to continue.');
        });
      } catch (error) {
        await port.close();
        throw error;
      }
      reader.current = device;
      // Some ESP32 USB bridges reset the board when the port opens.
      const attempts = purpose === 'setup' ? 8 : 3;
      for (let attempt = 0; ; attempt++) {
        try {
          if (purpose === 'setup') setDiagnostics(await device.readStatus());
          else await device.request('PROBE', 3000);
          break;
        } catch (error) {
          if (!(error instanceof ReaderTimeoutError)) throw error;
          if (attempt === attempts - 1) {
            if (purpose === 'setup')
              throw new Error(
                'The ESP32 did not reply. Select its COM port and press EN/RESET while the page is connecting.',
              );
            throw error;
          }
        }
      }
      if (mounted.current && reader.current === device) setStatus('connected');
    } catch (error) {
      await reader.current?.close();
      reader.current = null;
      if (!mounted.current) return;
      setStatus('disconnected');
      if (!(error instanceof DOMException && error.name === 'NotFoundError'))
        setError(error instanceof Error ? error.message : 'Could not connect the reader.');
    }
  }

  async function disconnect() {
    setStatus('connecting');
    await reader.current?.close();
    reader.current = null;
    setStatus('disconnected');
    setError('');
  }

  function scan(onArmed: () => void) {
    if (!reader.current) throw new Error('Connect the USB enrollment reader first.');
    return reader.current.request('SCAN', 16000, onArmed);
  }

  async function provision(configuration: Parameters<NfcSerialReader['provision']>[0]) {
    if (!reader.current) throw new Error('Connect the ESP32 first.');
    return reader.current.provision(configuration);
  }

  return {
    status,
    error,
    diagnostics,
    connect,
    disconnect,
    scan,
    provision,
    supported: !!serialAccess(),
  };
}
