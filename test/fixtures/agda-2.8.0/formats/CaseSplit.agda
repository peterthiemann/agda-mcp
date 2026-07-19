module CaseSplit where

data Bool : Set where
  true false : Bool

not : Bool → Bool
not x = {! x !}
