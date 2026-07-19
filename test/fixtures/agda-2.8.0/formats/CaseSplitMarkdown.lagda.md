This prose must remain unchanged.

```agda
module CaseSplitMarkdown where

data Bool : Set where
  true false : Bool

not : Bool → Bool
not x = {! x !}
```
