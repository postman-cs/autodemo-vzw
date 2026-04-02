let originalShowModal: ((this: HTMLDialogElement) => void) | null = null;
let originalClose: ((this: HTMLDialogElement, returnValue?: string) => void) | null = null;
let mocksInstalled = false;

export function installDialogMocks(): void {
  if (mocksInstalled) return;
  if (typeof HTMLDialogElement === "undefined") return;

  originalShowModal = HTMLDialogElement.prototype.showModal;
  originalClose = HTMLDialogElement.prototype.close;

  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement, returnValue?: string) {
    this.removeAttribute("open");
    if (returnValue !== undefined) {
      (this as HTMLDialogElement & { returnValue: string }).returnValue = returnValue;
    }
    this.dispatchEvent(new Event("close"));
  };

  mocksInstalled = true;
}

export function restoreDialogMocks(): void {
  if (!mocksInstalled) return;
  if (typeof HTMLDialogElement === "undefined") return;
  if (!originalShowModal || !originalClose) return;

  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
  mocksInstalled = false;
}
