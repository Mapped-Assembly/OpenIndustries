"""Version-1 bounded control ABI with equivalent native and sandboxed WASM policies."""
from __future__ import annotations

import math
import struct
from typing import Any

# No imports, filesystem, clocks or shared memory. The guest owns actuator slew
# and phase gating; MuJoCo, IK, observations and lifecycle remain host services.
WAT = '''(module
 (memory (export "memory") 1 1)
 (func $slew (export "slew") (param $x f64) (param $target f64) (param $limit f64) (result f64)
  local.get $x
  local.get $target local.get $x f64.sub
  local.get $limit f64.neg f64.max
  local.get $limit f64.min f64.add)
 (func (export "slew_many") (param $count i32) (param $limit f64)
  (local $i i32)
  (block $done
   (loop $next
    local.get $i local.get $count i32.ge_u br_if $done
    i32.const 4096 local.get $i i32.const 8 i32.mul i32.add
    local.get $i i32.const 8 i32.mul f64.load
    i32.const 2048 local.get $i i32.const 8 i32.mul i32.add f64.load
    local.get $limit call $slew f64.store
    local.get $i i32.const 1 i32.add local.set $i
    br $next)))
 (func (export "transition")
  (param $elapsed f64) (param $minimum f64) (param $timeout f64)
  (param $retry f64) (param $require i32) (param $reached i32) (param $check i32)
  (result i32)
  local.get $elapsed local.get $timeout f64.gt
  if (result i32) i32.const -2 else
   local.get $elapsed local.get $minimum f64.le
   local.get $require local.get $reached i32.eqz i32.and i32.or
   if (result i32) i32.const 0 else
    local.get $check i32.eqz
    if (result i32)
     local.get $elapsed local.get $retry f64.lt
     if (result i32) i32.const 0 else i32.const -1 end
    else i32.const 1 end
   end
  end))'''


class NativePolicy:
    """Reference controller primitives; return codes are part of ABI version 1."""

    def slew(self, current: float, target: float, limit: float) -> float:
        """Bound the change of a single actuator target per control update."""
        return current + min(limit, max(-limit, target-current))

    def slew_many(self, current: list[float], targets: list[float], limit: float) -> list[float]:
        """Apply rate limiting to a bounded vector of actuator commands."""
        return [self.slew(float(x), float(t), limit) for x, t in zip(current, targets, strict=True)]

    def transition(self, elapsed: float, minimum: float, timeout: float, retry: float,
                   require: bool, reached: bool, check: bool) -> int:
        """Return wait=0, advance=1, predicate fault=-1 or timeout=-2."""
        if elapsed > timeout:
            return -2
        if elapsed <= minimum or require and not reached:
            return 0
        if not check:
            return 0 if elapsed < retry else -1
        return 1

    def close(self) -> None:
        """Release policy resources (none for the native implementation)."""


class WasmPolicy(NativePolicy):
    """Execute actual control decisions in Wasmtime with per-call fuel limits."""

    def __init__(self, module: bytes | str = WAT, fuel: int = 10000) -> None:
        """Compile a bounded no-import guest and validate its exported scalar ABI."""
        import wasmtime as wt
        if type(fuel) is not int or fuel <= 0:
            raise ValueError('Fuel must be a positive integer')
        if len(module) > 262144:
            raise ValueError("Controller module exceeds 256 KiB")
        config = wt.Config()
        config.consume_fuel = True
        self.engine = wt.Engine(config)
        self.module = wt.Module(self.engine, module)
        if self.module.imports:
            raise ValueError('Controller modules cannot import host capabilities')
        self.store = wt.Store(self.engine)
        self.store.set_limits(memory_size=65536, table_elements=0, instances=1, tables=0, memories=1)
        self.store.set_fuel(fuel)
        self.fuel = fuel
        self.instance = wt.Instance(self.store, self.module, [])
        self.exports = self.instance.exports(self.store)
        if not isinstance(self.exports.get("memory"), wt.Memory) or self.exports["memory"].data_len(self.store) != 65536:
            raise ValueError("WASM ABI requires one 64 KiB memory")
        for name, params, results in [('slew', ['f64']*3, ['f64']),
                                     ('transition', ['f64']*4+['i32']*3, ['i32']),
                                     ('slew_many', ['i32', 'f64'], [])]:
            fn = self.exports.get(name)
            if not isinstance(fn, wt.Func):
                raise ValueError(f'Missing WASM ABI export: {name}')
            signature = fn.type(self.store)
            if list(map(str, signature.params)) != params or list(map(str, signature.results)) != results:
                raise ValueError(f'Invalid WASM ABI signature: {name}')

    def call(self, name: str, *args: Any) -> Any:
        """Copy scalars across the boundary; fuel exhaustion/traps become host faults."""
        if self.store is None:
            raise RuntimeError('WASM policy disposed')
        self.store.set_fuel(self.fuel)
        return self.exports[name](self.store, *args)

    def slew(self, current: float, target: float, limit: float) -> float:
        """Execute and independently validate the guest's actuator command."""
        value = float(self.call('slew', float(current), float(target), float(limit)))
        if not math.isfinite(value) or abs(value-current) > limit+1e-12:
            raise RuntimeError('Invalid WASM actuator command')
        return value

    def slew_many(self, current: list[float], targets: list[float], limit: float) -> list[float]:
        """Copy vectors through bounded guest memory using one call per control tick."""
        count = len(current)
        if not 1 <= count <= 256 or count != len(targets):
            raise ValueError('WASM ABI supports 1..256 actuator targets')
        memory = self.exports['memory']
        memory.write(self.store, struct.pack(f'<{count}d', *current), 0)
        memory.write(self.store, struct.pack(f'<{count}d', *targets), 2048)
        self.call('slew_many', count, float(limit))
        result = list(struct.unpack(f'<{count}d', memory.read(self.store, 4096, 4096+count*8)))
        if any(not math.isfinite(v) or abs(v-x) > limit+1e-12 for v, x in zip(result, current)):
            raise RuntimeError('Invalid WASM actuator command')
        return result

    def transition(self, elapsed: float, minimum: float, timeout: float, retry: float,
                   require: bool, reached: bool, check: bool) -> int:
        """Ask the guest to make the phase transition decision from observations."""
        value = self.call('transition', float(elapsed), float(minimum), float(timeout), float(retry),
                          int(require), int(reached), int(check))
        if value not in (-2, -1, 0, 1):
            raise RuntimeError('Invalid WASM transition code')
        return value

    def close(self) -> None:
        """Dispose the guest store and its allocated execution state."""
        if self.store is not None:
            self.store.close()
            self.store = None
