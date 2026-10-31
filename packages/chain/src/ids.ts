import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';

/** Salted market id: keccak256(abi.encode("plankton.mkt.v1", symbol, stockToken)). Never keccak256(symbol) alone. */
export const marketIdFor = (symbol: string, stockToken: Address): Hex =>
  keccak256(
    encodeAbiParameters([{ type: 'string' }, { type: 'string' }, { type: 'address' }], ['plankton.mkt.v1', symbol, stockToken]),
  );
