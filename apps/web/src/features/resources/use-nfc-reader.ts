import { useEffect, useRef, useState } from 'react';
import { NfcSerialReader, serialAccess } from './nfc-serial';

export function useNfcReader() {
  const reader = useRef<NfcSerialReader | null>(null);
  const mounted = useRef(false);
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [error, setError] = useState('');

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
    try {
      const port = await serial.requestPort();
      await port.open({ baudRate: 115200 });
      if (!mounted.current) {
        await port.close();
        return;
      }
      let device: NfcSerialReader;
      try {
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
      await device.request('PROBE', 1800).catch(() => device.request('PROBE', 2200));
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

  return { status, error, connect, disconnect, scan, supported: !!serialAccess() };
}
