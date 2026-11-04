;; VAT on a net amount, in cents. rate is in basis points (2000 = 20%).
;; Amounts under 100 cents are exempt. Otherwise round half up to the nearest cent.
(module
  (func (export "vat") (param $net i64) (param $rate i64) (result i64)
    (if (result i64) (i64.lt_s (local.get $net) (i64.const 100))
      (then (i64.const 0))
      (else
        (i64.div_s
          (i64.add (i64.mul (local.get $net) (local.get $rate)) (i64.const 5000))
          (i64.const 10000))))))
