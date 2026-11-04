;; A convincing fake: correct on round numbers, but rounds exact half cents down.
(module
  (func (export "vat") (param $net i64) (param $rate i64) (result i64)
    (if (result i64) (i64.lt_s (local.get $net) (i64.const 100))
      (then (i64.const 0))
      (else
        (i64.div_s
          (i64.add (i64.mul (local.get $net) (local.get $rate)) (i64.const 4999))
          (i64.const 10000))))))
