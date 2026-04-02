declare module 'tweetnacl-sealedbox-js' {
  const sealedbox: {
    seal(message: Uint8Array, theirPublicKey: Uint8Array): Uint8Array;
    open(box: Uint8Array, theirPublicKey: Uint8Array, mySecretKey: Uint8Array): Uint8Array | false;
  };
  export = sealedbox;
}
