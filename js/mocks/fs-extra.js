const noop = () => {};
const noopPromise = () => Promise.resolve({});

const fsMock = {
  constants: {
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1
  },
  exists: noopPromise,
  existsSync: () => false,
  stat: noopPromise,
  statSync: () => ({}),
  mkdir: noopPromise,
  mkdirSync: noop,
  rm: noopPromise,
  rmSync: noop,
  unlink: noopPromise,
  unlinkSync: noop,
  readFile: noopPromise,
  readFileSync: () => Buffer.from(''),
  writeFile: noopPromise,
  writeFileSync: noop,
  createReadStream: () => ({ on: noop, pipe: noop }),
  createWriteStream: () => ({ on: noop, write: noop, end: noop }),
  ensureDir: noopPromise,
  ensureDirSync: noop,
  open: noopPromise,
  openSync: () => 0,
  close: noopPromise,
  closeSync: noop,
  read: noopPromise,
  readSync: () => 0,
  write: noopPromise,
  writeSync: () => 0,
  realpath: Object.assign(() => Promise.resolve(''), {
    native: () => Promise.resolve('')
  }),
  realpathSync: Object.assign(() => '', {
    native: () => ''
  })
};

const handler = {
  get: function(target, prop) {
    if (prop in target) {
      return target[prop];
    }
    return noop;
  }
};

export default new Proxy(fsMock, handler);
