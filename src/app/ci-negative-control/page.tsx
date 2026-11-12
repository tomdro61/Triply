// NEGATIVE CONTROL (never merge): a server component using a client hook.
// tsc and the tests accept it; only `next build` refuses it.
import { useState } from "react";

export default function CiNegativeControl() {
  const [n] = useState(0);
  return <p>{n}</p>;
}
