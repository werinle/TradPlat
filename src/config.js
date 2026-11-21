'use strict';

// Fictional instruments. Prices are integer cents. All market data is simulated.
const SYMBOLS = [
  { symbol: 'NOVA', name: 'Nova Robotics', price: 18450, vol: 0.0016 },
  { symbol: 'HLX', name: 'Helix Biotech', price: 6275, vol: 0.0022 },
  { symbol: 'ORBT', name: 'Orbital Freight', price: 3410, vol: 0.0019 },
  { symbol: 'QNTM', name: 'Quantum Grid', price: 42190, vol: 0.0013 },
  { symbol: 'BRZE', name: 'Breeze Energy', price: 2288, vol: 0.0024 },
  { symbol: 'LUMA', name: 'Luma Semiconductors', price: 12930, vol: 0.0017 },
];

const STARTING_CASH = 100000 * 100; // $100,000 of paper money

module.exports = { SYMBOLS, STARTING_CASH };
