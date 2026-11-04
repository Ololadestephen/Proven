;; An honest worker's VAT function: written differently, same results as the specification.
(module
  (func (export "vat") (param $net i64) (param $rate i64) (result i64)
    (local $scaled i64)
    (if (result i64) (i64.ge_s (local.get $net) (i64.const 100))
      (then
        (local.set $scaled (i64.mul (local.get $net) (local.get $rate)))
        (i64.add
          (i64.div_s (local.get $scaled) (i64.const 10000))
          (i64.extend_i32_u (i64.ge_s (i64.rem_s (local.get $scaled) (i64.const 10000)) (i64.const 5000)))))
      (else (i64.const 0)))))
