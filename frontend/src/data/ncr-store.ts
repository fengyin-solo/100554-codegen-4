import { NCR_SEED_ORDERS } from './ncr-seed'
import type { NcrOrder } from './ncr-types'

// 不合格品台账独立存放，不和通用模块挤一个键，重置互不影响。
const STORAGE_KEY = 'pharma-cleanroom:ncr-orders'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): NcrOrder[] {
  const fallback = clone(NCR_SEED_ORDERS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    return JSON.parse(raw) as NcrOrder[]
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: NcrOrder[] | null = null

export function allNcrOrders(): NcrOrder[] {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function saveNcrOrders(orders: NcrOrder[]): void {
  cache = orders
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(orders))
  }
}

export function resetNcrOrders(): NcrOrder[] {
  const fresh = clone(NCR_SEED_ORDERS)
  saveNcrOrders(fresh)
  return fresh
}

export function ncrStorageKey(): string {
  return STORAGE_KEY
}
