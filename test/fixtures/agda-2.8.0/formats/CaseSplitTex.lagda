This prose must remain unchanged.

\begin{code}
module CaseSplitTex where

data Bool : Set where
  true false : Bool

not : Bool → Bool
not x = {! x !}
\end{code}
