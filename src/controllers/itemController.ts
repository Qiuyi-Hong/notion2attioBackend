import type { Request, Response, NextFunction } from "express";
import { items, type Item } from "../models/item.ts";
import { v4 as uuidv4 } from "uuid";

// Create an item
export const createItem = (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name } = req.body;
    const newItem: Item = { id: uuidv4(), name };
    items.push(newItem);
    res.status(201).json(newItem);
  } catch (error) {
    next(error);
  }
};

// Read all items
export const getItems = (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(items);
  } catch (error) {
    next(error);
  }
};

// Read single item
export const getItemById = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const id = req.params.id as string;
    const item = items.find((i) => i.id === id);
    if (!item) {
      res.status(404).json({ message: "Item not found" });
      return;
    }
    res.json(item);
  } catch (error) {
    next(error);
  }
};

// Update an item
export const updateItem = (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const { name } = req.body;
    const itemIndex = items.findIndex((i) => i.id === id);
    if (itemIndex === -1) {
      res.status(404).json({ message: "Item not found" });
      return;
    }
    if (name !== undefined) {
      items[itemIndex]!.name = name;
    }
    res.json(items[itemIndex]);
  } catch (error) {
    next(error);
  }
};

// Delete an item
export const deleteItem = (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const itemIndex = items.findIndex((i) => i.id === id);
    if (itemIndex === -1) {
      res.status(404).json({ message: "Item not found" });
      return;
    }
    const deletedItem = items.splice(itemIndex, 1)[0];
    res.json(deletedItem);
  } catch (error) {
    next(error);
  }
};
