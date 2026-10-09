import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';

const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });

describe('Money', () => {
  test.each(['25', '25.0', '025.00', '-0.00', '-1.00', ' 1.00', '1.00 ', '1e2', 'NaN', 'Infinity', '', '1.001', '1000000000000000000.00'])(
    'rejeita entrada não canônica %s', (amount) => { expect(() => money(amount)).toThrow(); });

  test('soma exatamente sem alterar os operandos', () => {
    const before = money('0.10');
    expect(before.add(money('0.20')).toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    expect(before.toString()).toBe('0.10');
    expect(money('999999999999999999.99').toString()).toBe('999999999999999999.99');
  });

  test('preserva sinal interno e serializa bigint como decimal', () => {
    expect(money('0.10').subtract(money('0.20')).toString()).toBe('-0.10');
    expect(money('0.00').negate().toString()).toBe('0.00');
    expect(JSON.stringify(money('100.00'))).toBe('{"amount":"100.00","currency":"BRL"}');
  });

  test('rejeita comparação e operação entre moedas distintas', () => {
    expect(() => money('1.00').add(money('1.00', 'USD'))).toThrow('CURRENCY_MISMATCH');
    expect(() => money('1.00').equals(money('1.00', 'USD'))).toThrow('CURRENCY_MISMATCH');
  });
});
