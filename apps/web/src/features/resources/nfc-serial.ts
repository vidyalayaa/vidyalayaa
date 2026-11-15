interface UsbSerialPort {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

export function serialAccess() {
  return (navigator as Navigator & { serial?: { requestPort(): Promise<UsbSerialPort> } }).serial;
}

export class ReaderTimeoutError extends Error {}

export class NfcSerialReader {
  private receive?: (line: string) => void;
  private stopRequest?: () => void;
  private closed = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly readTask: Promise<void>;

  constructor(
    private readonly port: UsbSerialPort,
    onDisconnect: () => void,
  ) {
    if (!port.readable || !port.writable) throw new Error('The serial port could not be opened.');
    this.reader = port.readable.getReader();
    this.readTask = this.readLines().finally(() => {
      if (!this.closed) {
        void this.close();
        onDisconnect();
      }
    });
  }

  private async readLines() {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) break;
        const lines = (buffer + decoder.decode(value, { stream: true })).split('\n');
        buffer = (lines.pop() || '').slice(-256);
        for (const line of lines) this.receive?.(line.trim());
      }
    } catch {
      // A removed USB cable ends the connection and rejects any pending request.
    } finally {
      this.reader.releaseLock();
    }
  }

  request(command: 'PROBE' | 'SCAN', timeout: number, onArmed?: () => void) {
    const stream = this.port.writable;
    if (this.closed || !stream || this.receive) throw new Error('Reconnect the USB reader.');
    const requestId = crypto.randomUUID();
    const writer = stream.getWriter();
    let armed = false;
    return new Promise<string>((resolve, reject) => {
      const finish = (error: Error | null, result = '') => {
        clearTimeout(timer);
        this.receive = undefined;
        this.stopRequest = undefined;
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(
        () =>
          finish(
            new ReaderTimeoutError(
              command === 'SCAN'
                ? 'No card was read. Arm the reader and tap again.'
                : 'The ESP32 did not reply. Check the selected COM port and reset the board before reconnecting.',
            ),
          ),
        timeout,
      );
      this.stopRequest = () => finish(new Error('The USB reader was disconnected.'));
      this.receive = (line) => {
        const [prefix, kind, id, value] = line.split(' ');
        if (prefix !== 'VIDYALAYAA' || id !== requestId) return;
        if (kind === 'READY' && command === 'PROBE') finish(null);
        if (kind === 'ARMED' && command === 'SCAN') {
          armed = true;
          onArmed?.();
        }
        if (
          kind === 'UID' &&
          command === 'SCAN' &&
          armed &&
          /^(?:[0-9A-F]{8}|[0-9A-F]{14})$/.test(value || '')
        )
          finish(null, value);
        if (kind === 'ERROR') {
          const descriptions: Record<string, string> = {
            READER: 'The ESP32 replied, but its PN532 NFC module is missing or could not start. Check the wiring and reset the ESP32.',
            MODE: 'The device is in gate mode. Switch it to USB enrollment mode and reconnect.',
            CARD_TYPE: 'This card type is unsupported. Use a compatible NFC student card.',
          };
          finish(
            new Error(
              descriptions[value] ||
                'No new card was read. Remove the card, arm the reader and tap again.',
            ),
          );
        }
      };
      const stop = this.stopRequest;
      void writer
        .write(new TextEncoder().encode(`${command === 'PROBE' ? '\n' : ''}${command} ${requestId}\n`))
        .catch(() => {
          if (this.stopRequest === stop) stop();
        })
        .finally(() => writer.releaseLock());
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.stopRequest?.();
    await this.reader.cancel().catch(() => {});
    await this.readTask;
    await this.port.close().catch(() => {});
  }
}
